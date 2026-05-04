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

  const upstream = await fetch(supabaseUrl, { headers: upstreamHeaders })

  if (!upstream.ok && upstream.status !== 206) {
    return new NextResponse(null, { status: upstream.status })
  }

  const headers = new Headers()
  headers.set('Content-Type', upstream.headers.get('Content-Type') ?? 'audio/mpeg')
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Cache-Control', 'public, max-age=3600')

  const contentLength = upstream.headers.get('Content-Length')
  if (contentLength) headers.set('Content-Length', contentLength)

  const contentRange = upstream.headers.get('Content-Range')
  if (contentRange) headers.set('Content-Range', contentRange)

  return new NextResponse(upstream.body, {
    status: range ? 206 : upstream.status,
    headers,
  })
}
