import { NextRequest, NextResponse } from 'next/server'
import { SUPABASE_URL } from '@/lib/supabase'

export const maxDuration = 60

// Audio proxy — forwards requests to Supabase Storage with proper Range request support.
// This ensures the browser's audio element can seek, determine full duration, and buffer
// correctly regardless of how Supabase's CDN handles Range headers.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params

  // Block path-traversal attempts — reject any segment containing '..' or null bytes
  if (path.some(segment => segment.includes('..') || segment.includes('\0'))) {
    return new NextResponse(null, { status: 400 })
  }

  const supabaseUrl = `${SUPABASE_URL}/storage/v1/object/public/mf-audio/${path.join('/')}`

  const range = req.headers.get('range')
  const upstreamHeaders: HeadersInit = {}
  if (range) upstreamHeaders['Range'] = range
  // Forward conditional-request headers so the browser's cache revalidation keeps working.
  const ifRange = req.headers.get('if-range')
  if (ifRange) upstreamHeaders['If-Range'] = ifRange
  const ifNoneMatch = req.headers.get('if-none-match')
  if (ifNoneMatch) upstreamHeaders['If-None-Match'] = ifNoneMatch

  let upstream: Response
  try {
    // Cap the upstream wait at 30s. Without it a stalled Supabase connection can
    // pin a Railway worker for the full 60s maxDuration, starving other requests.
    upstream = await fetch(supabaseUrl, {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(30000),
    })
  } catch {
    // Network blip or timeout talking to Supabase — surface as 502 so the element
    // can retry rather than throwing a 500 that looks like a hard failure.
    return new NextResponse(null, { status: 502 })
  }

  // 304 Not Modified — pass straight through (no body).
  if (upstream.status === 304) {
    return new NextResponse(null, { status: 304, headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } })
  }

  if (!upstream.ok && upstream.status !== 206) {
    return new NextResponse(null, { status: upstream.status })
  }

  // Guard against a header-only / empty-body upstream response. Streaming a null
  // body as a 200/206 hands the browser a zero-length media file it treats as
  // corrupt (ERR_INVALID_RESPONSE) instead of a recoverable error.
  if (!upstream.body) {
    return new NextResponse(null, { status: 502 })
  }

  const headers = new Headers()
  headers.set('Content-Type', upstream.headers.get('Content-Type') ?? 'audio/mpeg')
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')

  const contentLength = upstream.headers.get('Content-Length')
  if (contentLength) headers.set('Content-Length', contentLength)

  // A 206 is only valid when it carries Content-Range. Mirror upstream's real
  // status rather than forcing 206 whenever the client merely *sent* a Range:
  // if Supabase ignored the Range and returned a full 200, forging a 206 with no
  // Content-Range is an invalid partial response and breaks seeking in some browsers.
  const contentRange = upstream.headers.get('Content-Range')
  if (contentRange) headers.set('Content-Range', contentRange)

  // Pass through validators so range requests and caches stay coherent.
  const etag = upstream.headers.get('ETag')
  if (etag) headers.set('ETag', etag)
  const lastModified = upstream.headers.get('Last-Modified')
  if (lastModified) headers.set('Last-Modified', lastModified)

  // Only emit 206 when upstream genuinely returned partial content (it set a
  // Content-Range). Forging a 206 with no Content-Range is an invalid partial
  // response that breaks seeking/buffering in some browsers.
  const status = upstream.status === 206 && contentRange ? 206 : 200

  return new NextResponse(upstream.body, { status, headers })
}
