import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getSyncCatalogData } from '@/lib/sync-share'
import SyncCatalog from '@/components/SyncCatalog'

// Public sync catalog: mixbase.app/sync/<token> (migration 047). The token is
// the collection's share_token; the page exists only for a collection marked
// is_sync (see src/lib/sync-share.ts for why the flag is the gate).
export const dynamic = 'force-dynamic'

type Params = Promise<{ token: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { token } = await params
  const data = await getSyncCatalogData(token)
  if (!data) return { title: 'mixBASE', robots: { index: false, follow: false } }
  const title = `${data.artistName} — Sync catalog`
  const description = `${data.tracks.length} ${data.tracks.length === 1 ? 'track' : 'tracks'} with instrumentals. One-stop: master and publishing controlled by ${data.artistName}.`
  return {
    title: `${title} | mixBASE`,
    description,
    robots: { index: false, follow: false },
    openGraph: {
      title,
      description,
      ...(data.coverUrl ? { images: [{ url: data.coverUrl, alt: title }] } : {}),
    },
  }
}

export default async function SyncCatalogPage({ params }: { params: Params }) {
  const { token } = await params
  const data = await getSyncCatalogData(token)
  if (!data) notFound()
  return <SyncCatalog data={data} />
}
