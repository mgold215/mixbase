import { supabaseAdmin } from '@/lib/supabase'
import Link from 'next/link'
import Image from 'next/image'
import Nav from '@/components/Nav'
import { Music } from 'lucide-react'
import NewCollectionButton from './NewCollectionButton'

export const dynamic = 'force-dynamic'

const TYPE_LABEL: Record<string, string> = { album: 'Album', ep: 'EP', playlist: 'Playlist' }

type CollectionRow = {
  id: string
  title: string
  type: string
  cover_url: string | null
  updated_at: string
  mb_collection_items: { position: number; mb_projects: { artwork_url: string | null } | null }[]
}

export default async function CollectionsPage() {
  const { data } = await supabaseAdmin
    .from('mb_collections')
    .select('id, title, type, cover_url, updated_at, mb_collection_items(position, mb_projects(artwork_url))')
    .order('updated_at', { ascending: false })

  const collections = (data ?? []) as unknown as CollectionRow[]

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-page)' }}>
      <Nav />
      <div className="max-w-5xl mx-auto px-5 pt-20 pb-10">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text)' }}>Collections</h1>
          <NewCollectionButton />
        </div>

        {collections.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <Music size={48} style={{ color: 'var(--surface-3)' }} />
            <p style={{ color: 'var(--text-muted)' }}>No collections yet. Create an album, EP, or playlist.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {collections.map(c => {
              const artworks = [...c.mb_collection_items]
                .sort((a, b) => a.position - b.position)
                .map(i => i.mb_projects?.artwork_url)
                .filter((u): u is string => !!u)
                .slice(0, 4)

              return (
                <Link
                  key={c.id}
                  href={`/collections/${c.id}`}
                  className="group rounded-xl overflow-hidden transition-transform hover:scale-[1.02]"
                  style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--surface-2)' }}
                >
                  {/* Cover: explicit cover_url > 2×2 mosaic > placeholder */}
                  {c.cover_url ? (
                    <div className="aspect-square relative overflow-hidden">
                      <Image src={c.cover_url} alt={c.title} fill className="object-cover" unoptimized />
                    </div>
                  ) : (
                    <div className="aspect-square grid grid-cols-2" style={{ gap: 1, backgroundColor: 'var(--surface-2)' }}>
                      {[0, 1, 2, 3].map(i => (
                        <div key={i} className="relative overflow-hidden" style={{ backgroundColor: 'var(--surface-2)' }}>
                          {artworks[i] ? (
                            <Image src={artworks[i]} alt="" fill className="object-cover" unoptimized />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Music size={14} style={{ color: 'var(--surface-3)' }} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="p-3">
                    <p className="font-semibold text-sm truncate" style={{ color: 'var(--text)' }}>{c.title}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-xs font-medium" style={{ color: 'var(--accent)' }}>
                        {TYPE_LABEL[c.type] ?? c.type}
                      </span>
                      <span style={{ color: 'var(--surface-3)' }}>·</span>
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {c.mb_collection_items.length} {c.mb_collection_items.length === 1 ? 'track' : 'tracks'}
                      </span>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
