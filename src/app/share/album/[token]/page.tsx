import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { supabaseAdmin, displayArtworkUrl } from '@/lib/supabase'
import { COLLECTION_TYPE_LABEL } from '@/lib/collection-export'
import {
  ensureCollectionShareToken,
  isMissingCollectionShareToken,
  ensureProjectVisualizerColumn,
  isMissingVisualizerColumn,
} from '@/lib/schema-heal'
import AlbumPlayer, { type AlbumPlayerTrack } from '@/components/AlbumPlayer'

export const dynamic = 'force-dynamic'

type ProjectRow = {
  title: string | null
  genre: string | null
  artwork_url: string | null
  finalized_artwork_url: string | null
  visualizer_url?: string | null
}

async function getAlbumShareData(token: string) {
  const fetchCollection = () =>
    supabaseAdmin.from('mb_collections').select('*').eq('share_token', token).single()

  const firstTry = await fetchCollection()
  let collection = firstTry.data
  // Deploy raced migration 019: add the column via the Management API and retry.
  if (firstTry.error && isMissingCollectionShareToken(firstTry.error)) {
    await ensureCollectionShareToken()
    collection = (await fetchCollection()).data
  }
  if (!collection) return null

  // Track rows with their project. visualizer_url can predate migration 015 —
  // PostgREST rejects the whole select on a missing column, so retry without it.
  const selectItems = (withVisualizer: boolean) =>
    supabaseAdmin
      .from('mb_collection_items')
      .select(`project_id, position, mb_projects(title, genre, artwork_url, finalized_artwork_url${withVisualizer ? ', visualizer_url' : ''})`)
      .eq('collection_id', collection.id)
      .order('position', { ascending: true })

  const itemsTry = await selectItems(true)
  let items = itemsTry.data
  if (itemsTry.error && isMissingVisualizerColumn(itemsTry.error)) {
    ensureProjectVisualizerColumn()
    items = (await selectItems(false)).data
  }
  const rows = items ?? []
  const projectIds = rows.map(r => r.project_id)

  // Newest version per project — a shared album always plays the current mixes.
  const latestByProject = new Map<string, { audio_url: string; duration_seconds: number | null }>()
  if (projectIds.length > 0) {
    const { data: versions } = await supabaseAdmin
      .from('mb_versions')
      .select('project_id, audio_url, duration_seconds, version_number')
      .in('project_id', projectIds)
      .order('version_number', { ascending: false })
    for (const v of versions ?? []) {
      if (!latestByProject.has(v.project_id)) latestByProject.set(v.project_id, v)
    }
  }

  let artistName = 'mixBASE'
  if (collection.user_id) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('artist_name, display_name')
      .eq('id', collection.user_id)
      .single()
    if (profile) artistName = profile.artist_name || profile.display_name || 'mixBASE'
  }

  const tracks: AlbumPlayerTrack[] = rows.flatMap(row => {
    // supabase-js types the to-one join as an array; at runtime it's an object.
    const p = row.mb_projects as unknown as ProjectRow | null
    const version = latestByProject.get(row.project_id)
    // Tracks with no uploaded mix yet have nothing to play publicly — skip them.
    if (!p || !version?.audio_url) return []
    return [{
      id: row.project_id,
      title: p.title ?? 'Untitled',
      genre: p.genre ?? null,
      artworkUrl: displayArtworkUrl(p),
      visualizerUrl: p.visualizer_url ?? null,
      audioUrl: version.audio_url,
      duration: version.duration_seconds ?? null,
    }]
  })

  const coverUrl: string | null = collection.cover_url ?? tracks.find(t => t.artworkUrl)?.artworkUrl ?? null
  const typeLabel = COLLECTION_TYPE_LABEL[collection.type as string] ?? 'Album'

  return { title: collection.title as string, typeLabel, coverUrl, artistName, tracks }
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params
  const data = await getAlbumShareData(token)
  if (!data) return { title: 'mixBASE' }
  const description = `Listen to ${data.title} by ${data.artistName} on mixBASE — ${data.tracks.length} ${data.tracks.length === 1 ? 'track' : 'tracks'}`
  return {
    title: `${data.title} — ${data.artistName} | mixBASE`,
    description,
    openGraph: {
      title: `${data.title} — ${data.artistName}`,
      description,
      ...(data.coverUrl ? { images: [data.coverUrl] } : {}),
    },
  }
}

export default async function AlbumSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const data = await getAlbumShareData(token)
  if (!data) notFound()

  return (
    <div className="min-h-screen bg-black flex flex-col">
      {/* Header — matches the single-track share page */}
      <header
        className="relative z-50 flex-shrink-0 h-12 border-b flex items-center px-5"
        style={{ backgroundColor: 'var(--nav-bg)', borderColor: 'var(--border)' }}
      >
        <span className="font-[family-name:var(--font-jost)] flex items-baseline gap-0">
          <span className="text-[15px] font-bold tracking-[0.04em]" style={{ color: 'var(--text)' }}>mix</span>
          <span className="text-[15px] font-bold tracking-[0.04em]" style={{ color: 'var(--accent)' }}>BASE</span>
        </span>

        <span className="ml-auto text-[13px] font-[family-name:var(--font-jost)] tracking-wide">
          <span style={{ color: 'var(--accent)' }}>{data.artistName}</span>
          {' '}
          <span className="text-white">{data.typeLabel.toLowerCase()}</span>
          {' '}
          <span style={{ color: 'var(--text-muted)' }}>share</span>
        </span>
      </header>

      <AlbumPlayer
        title={data.title}
        typeLabel={data.typeLabel}
        coverUrl={data.coverUrl}
        artistName={data.artistName}
        tracks={data.tracks}
        sourceId="album-share-player"
        footnote="Shared privately via mixBASE"
      />
    </div>
  )
}
