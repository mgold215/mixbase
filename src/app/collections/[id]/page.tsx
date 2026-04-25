import { notFound } from 'next/navigation'
import Nav from '@/components/Nav'
import { supabaseAdmin } from '@/lib/supabase'
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
      .select('*, mb_projects(title, artwork_url, genre)')
      .eq('collection_id', id)
      .order('position', { ascending: true }),
    supabaseAdmin
      .from('mb_projects')
      .select('id, title, artwork_url')
      .eq('user_id', userId)
      .order('title'),
  ])

  if (collectionRes.error) notFound()

  return (
    <>
      <Nav />
      <CollectionClient
        collection={collectionRes.data}
        initialItems={itemsRes.data ?? []}
        allProjects={projectsRes.data ?? []}
      />
    </>
  )
}
