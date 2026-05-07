import { supabaseAdmin, displayArtworkUrl } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import Nav from '@/components/Nav'
import MediaClient from './MediaClient'

export const dynamic = 'force-dynamic'

export default async function MediaPage() {
  const userId = await getUserId()

  const [projectsRes, collectionsRes] = await Promise.all([
    supabaseAdmin
      .from('mb_projects')
      .select('id, title, artwork_url, finalized_artwork_url')
      .eq('user_id', userId)
      .not('artwork_url', 'is', null)
      .order('updated_at', { ascending: false }),
    supabaseAdmin
      .from('mb_collections')
      .select('id, title, type')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false }),
  ])

  return (
    <>
      <Nav />
      <MediaClient
        projects={(projectsRes.data ?? []).map(p => ({
          id: p.id,
          title: p.title,
          artwork_url: displayArtworkUrl(p),
        }))}
        collections={collectionsRes.data ?? []}
      />
    </>
  )
}
