import { supabaseAdmin } from '@/lib/supabase'
import Nav from '@/components/Nav'
import MediaClient from './MediaClient'

export const dynamic = 'force-dynamic'

export default async function MediaPage() {
  const [projectsRes, collectionsRes] = await Promise.all([
    supabaseAdmin
      .from('mb_projects')
      .select('id, title, artwork_url')
      .not('artwork_url', 'is', null)
      .order('updated_at', { ascending: false }),
    supabaseAdmin
      .from('mb_collections')
      .select('id, title, type')
      .order('updated_at', { ascending: false }),
  ])

  return (
    <>
      <Nav />
      <MediaClient
        projects={projectsRes.data ?? []}
        collections={collectionsRes.data ?? []}
      />
    </>
  )
}
