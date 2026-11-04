import { NextRequest, NextResponse } from 'next/server'
import { getTrackShareData, shareCoverUrl, shareTitle } from '@/lib/track-share'
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

  const data = await getTrackShareData(token)
  if (!data) return new NextResponse(null, { status: 404 })

  const cover = await fetchCover(shareCoverUrl(data))
  try {
    const png = await renderShareCard({
      title: shareTitle(data),
      artist: data.artistName,
      label: versionDisplayLabel(data.version),
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
