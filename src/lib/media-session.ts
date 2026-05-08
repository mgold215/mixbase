// Set Media Session metadata synchronously — must be called before audio.play() so iOS
// registers it in the user-gesture context. React effects fire after re-render (too late).
//
// iOS / Tesla AVRCP gotchas this routine handles:
// - Each artwork entry MUST have a `type` (mime). iOS silently drops entries without it,
//   which then leaves the Now Playing widget with no title at all on some firmware.
// - Title and artist are never empty strings — iOS treats `''` as "no metadata" and falls
//   back to nothing rather than the audio element URL.
export function applyMediaSession(
  title: string,
  artist: string,
  artworkUrl: string | null,
  playing: boolean,
) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  const mime = guessImageType(artworkUrl)
  const artwork = artworkUrl
    ? [
        { src: artworkUrl, sizes: '96x96',   type: mime },
        { src: artworkUrl, sizes: '256x256', type: mime },
        { src: artworkUrl, sizes: '512x512', type: mime },
      ]
    : []
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title:  title?.trim()  || 'mixBASE',
      artist: artist?.trim() || 'mixBASE',
      album:  'mixBASE',
      artwork,
    })
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
  } catch { /* ignore */ }
}

function guessImageType(url: string | null): string {
  if (!url) return 'image/png'
  const lower = url.split('?')[0].toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}
