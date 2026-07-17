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
  // Cap the wait for upstream *headers* at 30s so a stalled Supabase connection
  // can't pin the request indefinitely — but clear the timer once headers
  // arrive. AbortSignal.timeout() would keep ticking through body streaming and
  // sever any transfer longer than 30s (a full-file WAV download, or a browser
  // streaming a long mix over one open-ended Range request).
  const connectAbort = new AbortController()
  const connectTimer = setTimeout(() => connectAbort.abort(), 30000)
  try {
    upstream = await fetch(supabaseUrl, {
      headers: upstreamHeaders,
      signal: connectAbort.signal,
    })
  } catch {
    // Network blip or timeout talking to Supabase — surface as 502 so the element
    // can retry rather than throwing a 500 that looks like a hard failure.
    return new NextResponse(null, { status: 502 })
  } finally {
    clearTimeout(connectTimer)
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

  // ?download=1 turns the response into an attachment (streamed, so even a
  // 2 GB WAV never buffers in memory) saved under the original upload name
  // passed as ?filename=. The name is header-sanitized: CR/LF/quotes stripped
  // (header injection), ASCII fallback in filename= for old parsers, and the
  // full UTF-8 name RFC 5987-encoded in filename*.
  if (req.nextUrl.searchParams.get('download') === '1') {
    const fallback = path[path.length - 1] ?? 'audio'
    const clean = (req.nextUrl.searchParams.get('filename') ?? fallback)
      .replace(/[\r\n"\\]/g, '')
      .slice(0, 200) || fallback
    const ascii = clean.replace(/[^\x20-\x7e]/g, '_')
    const rfc5987 = encodeURIComponent(clean)
      .replace(/['()*!]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    headers.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987}`)
  }

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
