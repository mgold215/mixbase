// Saving media (finished videos, visualizer loops, artwork) to the user's
// device, seamlessly, on every platform:
//
//  - The HTML `download` attribute is ignored for cross-origin URLs, so a bare
//    <a download> to Supabase storage just navigates and plays the file inline
//    — the exact "it opens but I can't save it" failure.
//  - On iOS the ONLY way to land a video/image in the Photos library is the
//    native share sheet ("Save Video" / "Save Image"); file downloads always
//    go to the Files app. So on touch devices we fetch the bytes and hand them
//    to navigator.share as a File.
//  - Everywhere else we force a true download. Supabase storage supports
//    `?download=<filename>` (the server answers with Content-Disposition:
//    attachment), which streams straight to disk — no fetching a 300 MB video
//    into memory. Non-Supabase URLs fall back to a fetched blob: anchor.
//  - A `blob:` URL is ALREADY local bytes this page created, so it needs no
//    fetch at all — and must not get one. `new URL('blob:…').hostname` is '',
//    so it used to fall through to blobDownload() and fetch itself, which the
//    CSP `connect-src` blocks (verified on production: 'self' does NOT cover
//    blob:). That silently killed every free-visualizer download. Anchor it
//    directly instead: no CSP surface, no second copy in memory, no revoke race.

function safeFileName(baseName: string, ext: string): string {
  const safe = baseName.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'mixbase'
  return `${safe}.${ext}`
}

function extFrom(url: string, contentType: string | null, fallbackExt: string): string {
  const fromType = contentType?.split('/')[1]?.split(';')[0]
  const fromUrl = url.split('?')[0].split('.').pop()
  const ext = fromType || (fromUrl && fromUrl.length <= 5 ? fromUrl : '') || fallbackExt
  // MediaRecorder blobs report e.g. "webm;codecs=vp9" — already stripped — but
  // normalize the odd "x-matroska" style subtypes to something Finder-friendly.
  return ext.replace(/^x-/, '')
}

/** Supabase storage understands ?download=<name> → Content-Disposition: attachment. */
function supabaseAttachmentUrl(url: string, filename: string): string | null {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith('.supabase.co') || !u.pathname.startsWith('/storage/v1/object/public/')) return null
    u.searchParams.set('download', filename)
    return u.toString()
  } catch {
    return null
  }
}

/** In-memory bytes this page already holds — never needs (or survives) a fetch. */
function isBlobUrl(url: string): boolean {
  return url.startsWith('blob:')
}

function isTouchDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    // iPadOS 13+ masquerades as macOS but is still touch-first.
    || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent))
}

// Don't buffer huge files into memory for the share sheet — Safari will kill
// the tab long before a full-length 1080p video fits in a Blob. Past this size
// we go straight to the streamed attachment download.
const MAX_SHARE_BYTES = 150 * 1024 * 1024

function anchorDownload(href: string, filename: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

async function blobDownload(url: string, baseName: string, fallbackExt: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Download failed')
  const blob = await res.blob()
  const filename = safeFileName(baseName, extFrom(url, blob.type || null, fallbackExt))
  const objectUrl = URL.createObjectURL(blob)
  anchorDownload(objectUrl, filename)
  URL.revokeObjectURL(objectUrl)
}

/**
 * Save a remote media file to the device the way that platform expects:
 * share sheet with the file on touch devices (Photos-ready), true attachment
 * download everywhere else. Never navigates the page to the raw URL.
 */
export async function saveMedia(url: string, baseName: string, fallbackExt = 'mp4'): Promise<void> {
  // Touch devices: fetch the bytes and open the native share sheet so the user
  // can hit "Save Video" / "Save Image" (Photos) or AirDrop it. Any failure —
  // no share support, file too big, transient-activation expired mid-fetch —
  // falls through to the plain download below.
  if (isTouchDevice() && typeof navigator !== 'undefined' && typeof navigator.canShare === 'function') {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error('Fetch failed')
      const size = Number(res.headers.get('content-length') ?? '0')
      if (size > MAX_SHARE_BYTES) throw new Error('Too large to share in-memory')
      const blob = await res.blob()
      if (blob.size > MAX_SHARE_BYTES) throw new Error('Too large to share in-memory')
      const type = blob.type || (fallbackExt === 'mp4' ? 'video/mp4' : '')
      const filename = safeFileName(baseName, extFrom(url, type || null, fallbackExt))
      const file = new File([blob], filename, type ? { type } : undefined)
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] })
        return
      }
    } catch (e) {
      // User closed the share sheet — that's a completed interaction, not an
      // error to recover from with a surprise second download.
      if (e instanceof DOMException && e.name === 'AbortError') return
    }
  }

  const filename = safeFileName(baseName, extFrom(url, null, fallbackExt))

  // Same-origin in-memory bytes: anchor straight at them. Must come before the
  // blobDownload() fallback, whose fetch() the CSP blocks for blob: URLs.
  if (isBlobUrl(url)) {
    anchorDownload(url, filename)
    return
  }

  const attachment = supabaseAttachmentUrl(url, filename)
  if (attachment) {
    // Server-side Content-Disposition: streamed to disk, works at any size.
    anchorDownload(attachment, filename)
    return
  }
  await blobDownload(url, baseName, fallbackExt)
}

/** Back-compat name used by artwork call sites. Images are small — same flow. */
export async function downloadImage(url: string, baseName: string): Promise<void> {
  return saveMedia(url, baseName, 'jpg')
}
