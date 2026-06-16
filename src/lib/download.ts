// Force a browser download of a remote image. The HTML `download` attribute is
// ignored for cross-origin URLs, so artwork hosted on Supabase storage would
// otherwise just open in a tab. Fetching the bytes and handing the browser a
// blob: URL sidesteps that — connect-src in next.config.ts already allows the
// Supabase storage origin.
export async function downloadImage(url: string, baseName: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Download failed')
  const blob = await res.blob()

  // Prefer the extension from the response content-type, fall back to the URL.
  const ext =
    blob.type.split('/')[1]?.split(';')[0] ||
    url.split('?')[0].split('.').pop() ||
    'jpg'

  const safe = baseName.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'artwork'

  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = `${safe}.${ext}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objectUrl)
}
