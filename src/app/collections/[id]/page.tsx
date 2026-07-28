import { notFound } from 'next/navigation'
import Nav from '@/components/Nav'
import { supabaseAdmin, displayArtworkUrl } from '@/lib/supabase'
import { publicArtistName } from '@/lib/display-name'
import { getUserId } from '@/lib/auth'
import { ensureProjectVisualizerColumn, isMissingVisualizerColumn } from '@/lib/schema-heal'
import CollectionClient, { type TrackMeta } from './CollectionClient'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ id: string }> }

export default async function CollectionPage({ params }: Props) {
  const { id } = await params
  const userId = await getUserId()

  // visualizer_url can predate migration 015 — PostgREST rejects the whole
  // select on a missing column, so retry without it (same as the share page).
  const selectProjects = (withVisualizer: boolean) =>
    supabaseAdmin
      .from('mb_projects')
      .select(`id, title, genre, artwork_url, finalized_artwork_url${withVisualizer ? ', visualizer_url' : ''}`)
      .eq('user_id', userId)
      .order('title')

  const [collectionRes, itemsRes, projectsFirstTry] = await Promise.all([
    supabaseAdmin.from('mb_collections').select('*').eq('id', id).eq('user_id', userId).single(),
    supabaseAdmin
      .from('mb_collection_items')
      .select('*, mb_projects(title, artwork_url, finalized_artwork_url, genre)')
      .eq('collection_id', id)
      .order('position', { ascending: true }),
    selectProjects(true),
  ])

  if (collectionRes.error) notFound()

  let projects = projectsFirstTry.data
  if (projectsFirstTry.error && isMissingVisualizerColumn(projectsFirstTry.error)) {
    ensureProjectVisualizerColumn()
    projects = (await selectProjects(false)).data
  }
  // supabase-js can't statically parse the template-literal select string.
  const projectRows = (projects ?? []) as unknown as Array<{
    id: string
    title: string
    genre: string | null
    artwork_url: string | null
    finalized_artwork_url: string | null
    visualizer_url?: string | null
  }>

  // Newest version per project — powers the in-page album player (the current
  // mix for every track the user could add to this collection).
  const trackMeta: Record<string, TrackMeta> = {}
  if (projectRows.length > 0) {
    const { data: versions } = await supabaseAdmin
      .from('mb_versions')
      .select('project_id, audio_url, duration_seconds, version_number')
      .in('project_id', projectRows.map(p => p.id))
      .order('version_number', { ascending: false })
    for (const v of versions ?? []) {
      if (!trackMeta[v.project_id]) {
        trackMeta[v.project_id] = {
          audioUrl: v.audio_url ?? null,
          duration: v.duration_seconds ?? null,
          visualizerUrl: null,
        }
      }
    }
  }
  for (const p of projectRows) {
    if (p.visualizer_url && trackMeta[p.id]) trackMeta[p.id].visualizerUrl = p.visualizer_url
  }

  let artistName = 'mixBASE'
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('artist_name, display_name')
    .eq('id', userId)
    .single()
  if (profile) artistName = publicArtistName(profile, 'mixBASE')

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
  const allProjects = projectRows.map(p => ({
    id: p.id,
    title: p.title,
    genre: p.genre ?? null,
    artwork_url: displayArtworkUrl(p),
  }))

  return (
    <>
      <Nav />
      <CollectionClient
        collection={collectionRes.data}
        initialItems={items}
        allProjects={allProjects}
        trackMeta={trackMeta}
        artistName={artistName}
      />
    </>
  )
}
