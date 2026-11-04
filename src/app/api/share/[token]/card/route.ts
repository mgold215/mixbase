import { NextRequest, NextResponse } from 'next/server'
import { getTrackShareData, shareCoverUrl, shareTitle } from '@/lib/track-share'
import { getAlbumShareData } from '@/lib/album-share'
import { renderShareCard } from '@/lib/share-card'
import { versionDisplayLabel } from '@/lib/mix-status'
import { rateLimiter, ipKey, rateLimitHeaders } from '@/lib/rate-limit'

// GET /api/share/[token]/card — the 1200×630 link-preview image for one song.
//
// Referenced as og:image / twitter:image by the public player page, so the
// callers are link previewers (iMessage, WhatsApp, Slack, X, Discord), not
// browsers. Public under the /api/share/ prefix; gated on the token alone,
// and it draws only what the page itself already shows (cover, title, artist,
// mix label). Cached for a day; the page busts it with ?v=<stamp> when the
// cover or title changes.

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/
// Previewers from one chat service can share an IP; a card costs one cover
// fetch and ~100 ms of drawing.
const cardLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 300 })
const MAX_COVER_BYTES = 30 * 1024 * 1024

async function fetchCover(url: string | null): Promise<Buffer | null> {
  if (!url) return null
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_COVER_BYTES) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > MAX_COVER_BYTES ? null : buf
  } catch {
    return null
  }
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limit = cardLimiter.check(ipKey(request))
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const { token } = await ctx.params
  if (!TOKEN_RE.test(token)) return new NextResponse(null, { status: 404 })

  // A song, or — the same token space — an album/collection.
  let card: { title: string; artist: string; label: string | null; coverUrl: string | null } | null = null
  const track = await getTrackShareData(token)
  if (track) {
    card = { title: shareTitle(track), artist: track.artistName, label: versionDisplayLabel(track.version), coverUrl: shareCoverUrl(track) }
  } else {
    const album = await getAlbumShareData(token)
    if (album) {
      const n = album.tracks.length
      card = { title: album.title, artist: album.artistName, label: `${album.typeLabel} · ${n} ${n === 1 ? 'track' : 'tracks'}`, coverUrl: album.coverUrl }
    }
  }
  if (!card) return new NextResponse(null, { status: 404 })

  const cover = await fetchCover(card.coverUrl)
  try {
    const png = await renderShareCard({
      title: card.title,
      artist: card.artist,
      label: card.label,
      cover,
    })
    return new NextResponse(new Uint8Array(png), {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(png.length),
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      },
    })
  } catch (err) {
    console.error('[share-card] render failed:', err instanceof Error ? err.message : err)
    return new NextResponse(null, { status: 500 })
  }
}
