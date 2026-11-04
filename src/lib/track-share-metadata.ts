import type { Metadata } from 'next'
import { shareCardStamp, shareTitle, type TrackShareData } from '@/lib/track-share'
import { trackShareUrl } from '@/lib/share-url'

// The <head> for a shared song, identical at both of its addresses. The link
// card is a 1200×630 image drawn for THIS song (cover, title, artist) by
// GET /api/share/<token>/card; metadataBase in layout.tsx makes the relative
// path absolute. iMessage, WhatsApp, Slack and X all read these tags.
export function trackShareMetadata(token: string, data: TrackShareData): Metadata {
  const projectTitle = shareTitle(data)
  const { artistName } = data
  const description = `Listen to ${projectTitle} by ${artistName} on mixBASE`
  const card = `/api/share/${encodeURIComponent(token)}/card?v=${shareCardStamp(data)}`
  const title = `${projectTitle} — ${artistName}`
  return {
    title: `${title} | mixBASE`,
    description,
    alternates: { canonical: trackShareUrl(token, { artistName, title: projectTitle }) },
    openGraph: {
      type: 'music.song',
      title,
      description,
      images: [{ url: card, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [card],
    },
  }
}
