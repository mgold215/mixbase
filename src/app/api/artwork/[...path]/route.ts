import { NextRequest, NextResponse } from 'next/server'
import { SUPABASE_URL } from '@/lib/supabase'

export const maxDuration = 30

// Artwork proxy — serves mf-artwork images from our OWN origin.
//
// Why this exists: the iOS lock-screen / Control Center "now playing" artwork is
// fetched by WebKit's media process, which is far stricter than an <img> tag and
// routinely refuses to load cross-origin images. That's why in-app artwork (a plain
// <img>) works while the lock screen shows nothing. Routing the MediaMetadata artwork
// through a same-origin URL (img-src 'self') makes WebKit load it reliably.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params

  // Block path-traversal — reject any segment containing '..' or null bytes.
  if (path.some(segment => segment.includes('..') || segment.includes('\0'))) {
    return new NextResponse(null, { status: 400 })
  }

  const supabaseUrl = `${SUPABASE_URL}/storage/v1/object/public/mf-artwork/${path.join('/')}`

  const upstreamHeaders: HeadersInit = {}
  const ifNoneMatch = req.headers.get('if-none-match')
  if (ifNoneMatch) upstreamHeaders['If-None-Match'] = ifNoneMatch

  let upstream: Response
  try {
    upstream = await fetch(supabaseUrl, { headers: upstreamHeaders })
  } catch {
    return new NextResponse(null, { status: 502 })
  }

  if (upstream.status === 304) {
    return new NextResponse(null, { status: 304, headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } })
  }

  if (!upstream.ok) {
    return new NextResponse(null, { status: upstream.status })
  }

  if (!upstream.body) {
    return new NextResponse(null, { status: 502 })
  }

  const headers = new Headers()
  headers.set('Content-Type', upstream.headers.get('Content-Type') ?? 'image/jpeg')
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  const contentLength = upstream.headers.get('Content-Length')
  if (contentLength) headers.set('Content-Length', contentLength)
  const etag = upstream.headers.get('ETag')
  if (etag) headers.set('ETag', etag)

  return new NextResponse(upstream.body, { status: 200, headers })
}
