// Set Media Session metadata synchronously — must be called before audio.play() so iOS
// registers it in the user-gesture context. React effects fire after re-render (too late).
export function applyMediaSession(title: string, artworkUrl: string | null, playing: boolean) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  const artwork = artworkUrl
    ? [
        { src: artworkUrl, sizes: '96x96' },
        { src: artworkUrl, sizes: '256x256' },
        { src: artworkUrl, sizes: '512x512' },
      ]
    : []
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || 'mixBase',
      artist: 'mixBase',
      album: 'mixBase',
      artwork,
    })
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
  } catch { /* ignore */ }
}
