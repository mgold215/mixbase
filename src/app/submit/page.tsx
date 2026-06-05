import { supabaseAdmin, displayArtworkUrl } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import Nav from '@/components/Nav'
import SubmitClient from './SubmitClient'
import type { Curator, SbSubmission, Song } from '@/lib/submit'

export const dynamic = 'force-dynamic'

export default async function SubmitPage() {
  const userId = await getUserId()

  // Songs come straight from the user's mixBASE projects + their versions.
  const projectsRes = await supabaseAdmin
    .from('mb_projects')
    .select('id, title, genre, artwork_url, finalized_artwork_url, share_token, mb_versions(id, version_number, audio_url, status)')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  const songs: Song[] = (projectsRes.data ?? []).map((p) => {
    type V = { id: string; version_number: number; audio_url: string | null; status: string | null }
    const versions: V[] = (p.mb_versions ?? []) as V[]
    const latest = [...versions]
      .filter((v) => v.audio_url)
      .sort((a, b) => b.version_number - a.version_number)[0]
    return {
      project_id: p.id,
      title: p.title,
      genre: p.genre,
      artwork_url: displayArtworkUrl(p),
      share_token: p.share_token,
      latest_version_id: latest?.id ?? null,
      status: latest?.status ?? null,
    }
  })

  const curatorsRes = await supabaseAdmin
    .from('sb_curators')
    .select('*')
    .or(`user_id.eq.${userId},user_id.is.null`)
    .order('name')

  const submissionsRes = await supabaseAdmin
    .from('sb_submissions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-page)' }}>
      <Nav />
      <div className="pt-14">
        <SubmitClient
          songs={songs}
          initialCurators={(curatorsRes.data ?? []) as Curator[]}
          initialSubmissions={(submissionsRes.data ?? []) as SbSubmission[]}
          userId={userId}
        />
      </div>
    </div>
  )
}
