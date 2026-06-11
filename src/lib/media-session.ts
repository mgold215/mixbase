import { artworkProxyUrl } from '@/lib/supabase'

// Set Media Session metadata synchronously — must be called before audio.play() so iOS
// registers it in the user-gesture context. React effects fire after re-render (too late).
export function applyMediaSession(title: string, artworkUrl: string | null, playing: boolean, artist = 'mixBase') {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return

  // iOS fetches lock-screen artwork in WebKit's media process, which refuses most
  // cross-origin images — so route it through our same-origin proxy and hand WebKit an
  // absolute URL it can resolve regardless of the current page path.
  let artwork: MediaImage[] = []
  if (artworkUrl) {
    let src = artworkProxyUrl(artworkUrl)
    if (src.startsWith('/') && typeof location !== 'undefined') {
      src = location.origin + src
    }
    // Provide the same image at descending sizes — iOS picks the largest it can use.
    // Omit `type`: we don't know the real MIME (jpeg/png/webp) and a mismatched hint
    // makes WebKit skip the image.
    artwork = [
      { src, sizes: '512x512' },
      { src, sizes: '256x256' },
      { src, sizes: '96x96' },
    ]
  }

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || 'mixBase',
      artist: artist || 'mixBase',
      artwork,
    })
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
  } catch { /* ignore */ }
}
