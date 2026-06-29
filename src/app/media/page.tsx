import { supabaseAdmin } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import Nav from '@/components/Nav'
import MediaClient from './MediaClient'

export const dynamic = 'force-dynamic'

export default async function MediaPage() {
  const userId = await getUserId()

  // Media tab is the user's image library — only originals belong here.
  // Finalized renders (text overlay baked into the bitmap) are derived
  // outputs and intentionally excluded.
  const [projectsRes, collectionsRes, visualizersRes] = await Promise.all([
    supabaseAdmin
      .from('mb_projects')
      .select('id, title, artwork_url')
      .eq('user_id', userId)
      .not('artwork_url', 'is', null)
      .order('updated_at', { ascending: false }),
    supabaseAdmin
      .from('mb_collections')
      .select('id, title, type')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false }),
    // Generated video loops (free canvas renders + Runway AI), newest first.
    supabaseAdmin
      .from('mb_visualizers')
      .select('id, title, video_url, project_id, kind, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(500),
  ])

  return (
    <>
      <Nav />
      <MediaClient
        projects={projectsRes.data ?? []}
        collections={collectionsRes.data ?? []}
        visualizers={visualizersRes.data ?? []}
      />
    </>
  )
}
