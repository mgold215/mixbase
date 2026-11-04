import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTrackShareData } from '@/lib/track-share'
import { trackShareMetadata } from '@/lib/track-share-metadata'
import TrackShareScreen from '@/components/TrackShareScreen'

// The original share address — mixbase.app/share/<token> — which every link
// ever sent still points at. It serves the SAME screen and the same <head> as
// the canonical /listen/<artist>/<title>/<token> (which the <head> names as
// canonical), rather than redirecting: a link that is already in someone's
// chat must keep working exactly as it did, with no previewer or client asked
// to follow a redirect. Newly copied links use the pretty form.
export const dynamic = 'force-dynamic'

type Params = Promise<{ token: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { token } = await params
  const data = await getTrackShareData(token)
  if (!data) return { title: 'mixBASE' }
  return trackShareMetadata(token, data)
}

export default async function SharePage({ params }: { params: Params }) {
  const { token } = await params
  const data = await getTrackShareData(token)
  if (!data) notFound()
  return <TrackShareScreen data={data} />
}
