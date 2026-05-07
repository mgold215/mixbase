import { notFound } from 'next/navigation'
import Nav from '@/components/Nav'
import { supabaseAdmin, displayArtworkUrl } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import CollectionClient from './CollectionClient'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ id: string }> }

export default async function CollectionPage({ params }: Props) {
  const { id } = await params
  const userId = await getUserId()

  const [collectionRes, itemsRes, projectsRes] = await Promise.all([
    supabaseAdmin.from('mb_collections').select('*').eq('id', id).eq('user_id', userId).single(),
    supabaseAdmin
      .from('mb_collection_items')
      .select('*, mb_projects(title, artwork_url, finalized_artwork_url, genre)')
      .eq('collection_id', id)
      .order('position', { ascending: true }),
    supabaseAdmin
      .from('mb_projects')
      .select('id, title, artwork_url, finalized_artwork_url')
      .eq('user_id', userId)
      .order('title'),
  ])

  if (collectionRes.error) notFound()

  // Coalesce finalized → source so listing UI continues to show the rendered
  // cover (with text overlay) when present, source artwork otherwise.
  const items = (itemsRes.data ?? []).map(item => ({
    ...item,
    mb_projects: item.mb_projects
      ? {
          title: (item.mb_projects as { title: string }).title,
          artwork_url: displayArtworkUrl(item.mb_projects as { artwork_url?: string | null; finalized_artwork_url?: string | null }),
          genre: (item.mb_projects as { genre: string | null }).genre,
        }
      : null,
  }))
  const allProjects = (projectsRes.data ?? []).map(p => ({
    id: p.id,
    title: p.title,
    artwork_url: displayArtworkUrl(p),
  }))

  return (
    <>
      <Nav />
      <CollectionClient
        collection={collectionRes.data}
        initialItems={items}
        allProjects={allProjects}
      />
    </>
  )
}
